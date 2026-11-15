
    
    

with all_values as (

    select
        status as value_field,
        count(*) as n_records

    from GREENHOUSE_ANALYTICS.GREENHOUSE_DBT_marts.fct_environmental_score_hourly
    group by status

)

select *
from all_values
where value_field not in (
    'complete','incomplete'
)


